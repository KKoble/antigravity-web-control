import asyncio
import json
import os
import shutil
import sys
from typing import AsyncGenerator, Dict, Any, Optional
from app.config import AGY_PATH

def get_executable_agy_path() -> str:
    which_path = shutil.which("agy")
    if which_path and os.path.exists(which_path):
        return which_path
    if os.path.exists(AGY_PATH):
        return AGY_PATH
    return "agy"

async def run_agy_stream(
    prompt: str,
    conversation_id: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    cwd: Optional[str] = None,
    approval_mode: bool = False,
    on_process_created: Optional[Any] = None
) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Launch agy with stream-json output and yield real-time events.
    """
    agy_exec = get_executable_agy_path()
    work_dir = cwd or os.getcwd()

    cmd = [
        agy_exec,
        "--output-format", "stream-json",
        "--print-timeout", "180s",
    ]

    if not approval_mode:
        cmd.append("--dangerously-skip-permissions")

    if conversation_id:
        cmd.extend(["--conversation", conversation_id])
    if model:
        cmd.extend(["--model", model])
    if effort:
        effort_val = "high" if effort.lower() in ("high", "max") else effort.lower()
        cmd.extend(["--effort", effort_val])

    cmd.extend(["-p", prompt])

    kwargs = {
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
        "stdin": asyncio.subprocess.PIPE,
        "cwd": work_dir,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            **kwargs
        )
    except Exception as e:
        yield {"type": "error", "message": f"agy 프로세스 실행 실패: {str(e)}"}
        return

    if on_process_created:
        try:
            on_process_created(process)
        except Exception:
            pass

    captured_conv_id = conversation_id
    emitted_any_token = False

    # Asynchronously drain stderr in the background to prevent pipe deadlock
    stderr_lines = []
    async def drain_stderr():
        try:
            while True:
                err_line = await process.stderr.readline()
                if not err_line:
                    break
                decoded_err = err_line.decode("utf-8", errors="replace").strip()
                if decoded_err:
                    stderr_lines.append(decoded_err)
        except Exception:
            pass

    stderr_task = asyncio.create_task(drain_stderr())

    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break

            decoded = line.decode("utf-8", errors="replace").strip()
            if not decoded:
                continue

            try:
                event_data = json.loads(decoded)
                event_type = event_data.get("event")

                if event_type == "init":
                    conv_id = event_data.get("conversation_id")
                    if conv_id:
                        captured_conv_id = conv_id
                        print(f"\n\033[96m[🌐 Web -> CLI Session]\033[0m conversation_id: {conv_id}", flush=True)
                        print(f"\033[90m[팁] CLI에서 이어하기: agy --conversation {conv_id}\033[0m\n", flush=True)
                        yield {"type": "init", "conversation_id": conv_id}

                elif event_type == "step_update":
                    update = event_data.get("step_update", {})
                    
                    # Text delta
                    text_delta = update.get("text_delta")
                    if text_delta:
                        emitted_any_token = True
                        sys.stdout.write(text_delta)
                        sys.stdout.flush()
                        yield {"type": "token", "delta": text_delta}

                    # Thought delta
                    thought_delta = update.get("thought_delta")
                    if thought_delta:
                        yield {"type": "thought", "delta": thought_delta}

                    # Direct thinking field
                    thinking = update.get("thinking")
                    if thinking:
                        yield {"type": "thought", "delta": thinking}

                    # Tool execution step
                    step_type = update.get("step_type")
                    if step_type == "tool":
                        tool_name = update.get("tool_name") or update.get("tool_info", {}).get("name", "tool")
                        tool_state = update.get("state", "RUNNING")
                        tool_args = update.get("tool_args") or update.get("args") or update.get("tool_info", {}).get("args", {})
                        
                        tool_name_lower = str(tool_name).lower()
                        is_edit = bool("edit" in tool_name_lower or "write" in tool_name_lower or "replace" in tool_name_lower)
                        is_read = bool("view_file" in tool_name_lower or "read" in tool_name_lower)
                        is_run = bool("run_command" in tool_name_lower or "cmd" in tool_name_lower)
                        action_type = "edit" if is_edit else ("read" if is_read else ("run" if is_run else "generic"))

                        target_file = ""
                        instruction = ""
                        target_content = ""
                        replacement_content = ""
                        if isinstance(tool_args, dict):
                            target_file = tool_args.get("TargetFile") or tool_args.get("AbsolutePath") or ""
                            instruction = tool_args.get("Instruction") or tool_args.get("Description") or ""
                            target_content = tool_args.get("TargetContent") or ""
                            replacement_content = tool_args.get("ReplacementContent") or tool_args.get("CodeContent") or ""

                        cmd_target = target_file or (tool_args.get('CommandLine') if isinstance(tool_args, dict) else '')
                        print(f"\n\033[93m[⚡ CLI 도구 실행]\033[0m {tool_name}({cmd_target})", flush=True)

                        yield {
                            "type": "tool_step",
                            "name": tool_name,
                            "state": tool_state,
                            "args": tool_args,
                            "action_type": action_type,
                            "is_file_edit": is_edit,
                            "target_file": target_file,
                            "instruction": instruction,
                            "target_content": target_content,
                            "replacement_content": replacement_content,
                            "approval_required": approval_mode
                        }

                elif event_type == "result":
                    res = event_data.get("result", {})
                    usage = res.get("usage", {})
                    response_text = res.get("response", "")

                    print(f"\n\n\033[92m[✓ 완료]\033[0m 상태: {res.get('status', 'SUCCESS')}\n", flush=True)

                    if usage:
                        yield {"type": "usage", "usage": usage}

                    yield {
                        "type": "result",
                        "conversation_id": res.get("conversation_id", captured_conv_id),
                        "response": response_text,
                        "status": res.get("status", "SUCCESS"),
                        "duration_seconds": res.get("duration_seconds", 0),
                        "usage": usage,
                        "emitted_any_token": emitted_any_token
                    }

            except json.JSONDecodeError:
                # Raw text line from agy
                if "jetski:" in decoded or "error" in decoded.lower():
                    yield {"type": "log", "text": decoded}

        await process.wait()
        if not stderr_task.done():
            stderr_task.cancel()

        if process.returncode != 0 and process.returncode is not None:
            stderr_out = "\n".join(stderr_lines).strip()
            if stderr_out:
                yield {"type": "error", "message": f"에이전트 실행 중 오류: {stderr_out}"}

    except asyncio.CancelledError:
        if not stderr_task.done():
            stderr_task.cancel()
        try:
            process.terminate()
            await asyncio.sleep(0.5)
            if process.returncode is None:
                process.kill()
        except Exception:
            pass
        yield {"type": "stopped", "message": "작업이 중단되었습니다."}
        raise
    except Exception as e:
        if not stderr_task.done():
            stderr_task.cancel()
        yield {"type": "error", "message": f"스트리밍 처리 오류: {str(e)}"}
