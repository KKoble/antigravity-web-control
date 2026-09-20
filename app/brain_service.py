import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional
from app.config import BRAIN_DIR, ROOT_DIR

def clean_text(text: str) -> str:
    """Clean system wrappers and metadata tags from text."""
    if not text:
        return ""
    # Extract user prompt from <USER_REQUEST> if present
    match = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, re.DOTALL)
    if match:
        text = match.group(1)
    
    # Strip metadata and settings boilerplate
    text = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", text, flags=re.DOTALL)
    text = re.sub(r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>", "", text, flags=re.DOTALL)
    text = re.sub(r"<SYSTEM_MESSAGE>.*?</SYSTEM_MESSAGE>", "", text, flags=re.DOTALL)
    return text.strip()

def is_internal_boilerplate(text: str) -> bool:
    """Check if content is internal agent framework chatter rather than user-facing answer."""
    if not text:
        return True
    boilerplate_markers = [
        "YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS",
        "Tool is running as a background task",
        "Task logs are available at:",
        "The command exited with code",
        "All your subagents and background tasks have been stopped",
        "jetski: no output produced",
        "Created At: 2026-",
        "Completed At: 2026-",
        "Do not attempt to circumvent this denial",
        "permission check failed for command",
    ]
    return any(marker in text for marker in boilerplate_markers)

SAFE_CONV_ID_REGEX = re.compile(r"^[a-zA-Z0-9_\-]+$")

def validate_conv_id(conv_id: str) -> bool:
    """Strictly validate conversation ID to prevent Path Traversal attacks."""
    if not conv_id or not isinstance(conv_id, str):
        return False
    if not SAFE_CONV_ID_REGEX.match(conv_id):
        return False
    try:
        target = (BRAIN_DIR / conv_id).resolve()
        target.relative_to(BRAIN_DIR.resolve())
        return True
    except (ValueError, RuntimeError):
        return False

def get_conversation_title(conv_id: str, transcript_path: Path) -> str:
    """Read the first user prompt from transcript to use as conversation title."""
    if not validate_conv_id(conv_id):
        return "잘못된 대화 ID"
    if not transcript_path.exists():
        return f"대화 {conv_id[:8]}"
    
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    if data.get("type") == "USER_INPUT" or data.get("source") == "USER_EXPLICIT":
                        clean = clean_text(data.get("content", ""))
                        if clean:
                            first_line = clean.split("\n")[0].strip()
                            return first_line[:35] + ("..." if len(first_line) > 35 else "")
                except Exception:
                    continue
    except Exception:
        pass

    return f"대화 {conv_id[:8]}"

def list_conversations() -> List[Dict[str, Any]]:
    """Scan ~/.gemini/antigravity-cli/brain and list all conversations sorted by latest."""
    if not BRAIN_DIR.exists():
        return []

    conversations = []
    for entry in BRAIN_DIR.iterdir():
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        transcript_path = entry / ".system_generated" / "logs" / "transcript.jsonl"
        mtime = entry.stat().st_mtime
        if transcript_path.exists():
            try:
                mtime = max(mtime, transcript_path.stat().st_mtime)
            except Exception:
                pass

        title = get_conversation_title(entry.name, transcript_path)
        updated_dt = datetime.fromtimestamp(mtime, tz=timezone.utc)

        conversations.append({
            "id": entry.name,
            "title": title,
            "updated_at": updated_dt.isoformat(),
            "updated_timestamp": mtime,
            "has_transcript": transcript_path.exists()
        })

    conversations.sort(key=lambda x: x["updated_timestamp"], reverse=True)
    return conversations

def format_file_path(p: str) -> str:
    if not p:
        return ""
    p = str(p).strip('"\'')
    p_norm = p.replace("\\", "/")
    
    # 1. Check workspace root (C:/Users/Seungchan/Desktop/codex/test)
    root_str = str(ROOT_DIR).replace("\\", "/").rstrip("/")
    if p_norm.lower().startswith(root_str.lower()):
        rel = p_norm[len(root_str):].lstrip("/")
        return rel or "./"

    # 2. Check brain scratch directory
    if "/scratch/" in p_norm:
        return "scratch/" + p_norm.split("/scratch/")[-1]

    # 3. Check brain logs or system directory
    if "/brain/" in p_norm:
        parts = p_norm.split("/brain/")[-1].split("/")
        if len(parts) >= 2:
            return ".../" + "/".join(parts[1:])
        return parts[-1]

    # 4. Check user home
    user_home = str(Path.home()).replace("\\", "/").rstrip("/").lower()
    if p_norm.lower().startswith(user_home):
        return "~" + p_norm[len(user_home):]

    # 5. Shorten very long paths
    parts = p_norm.split("/")
    if len(parts) > 3:
        return ".../" + "/".join(parts[-2:])
    return p_norm

def clean_command_label(cmd: str) -> str:
    if not cmd:
        return ""
    cmd = cmd.strip()

    # Remove powershell -Command "..."
    ps_m = re.match(r'^(?:powershell|pwsh)(?:\.exe)?\s+-Command\s+["\']?(.*?)["\']?$', cmd, re.I | re.DOTALL)
    if ps_m:
        cmd = ps_m.group(1).strip()

    # Remove cmd /c "..."
    cmd_m = re.match(r'^cmd(?:\.exe)?\s+/c\s+["\']?(.*?)["\']?$', cmd, re.I)
    if cmd_m:
        cmd = cmd_m.group(1).strip()

    # Unescape \" -> "
    cmd = cmd.replace(r'\"', '"').replace(r"\'", "'")

    # If python -c "..."
    py_inline = re.match(r'^python(?:\.exe)?\s+-c\s+["\']?(.*)$', cmd, re.DOTALL)
    if py_inline:
        inner = py_inline.group(1).strip().strip("\"'")
        first_line = inner.split("\n")[0].strip()
        return f"python: {first_line[:40]}"

    # If python script.py
    py_script = re.match(r'^python(?:\.exe)?\s+([^\s]+)(.*)$', cmd)
    if py_script:
        script_path = format_file_path(py_script.group(1))
        rest = py_script.group(2).strip()
        return f"python {script_path} {rest[:20]}".strip()

    # Otherwise, take first line
    first_line = cmd.split("\n")[0].strip()
    if len(first_line) > 45:
        return first_line[:42] + "..."
    return first_line

def format_tool_action(name: str, args: Any) -> Optional[Dict[str, str]]:
    if not isinstance(args, dict):
        return {"type": "generic", "label": f"● {name}()", "name": name}
    
    if name == "view_file":
        raw_path = args.get("AbsolutePath") or args.get("TargetFile") or ""
        target = format_file_path(raw_path)
        return {"type": "read", "label": f"● Read({target})", "target": target, "name": name}
    elif name in ("replace_file_content", "write_to_file", "edit_file", "multi_replace_file_content"):
        raw_path = args.get("TargetFile") or args.get("AbsolutePath") or ""
        target = format_file_path(raw_path)
        instruction = args.get("Instruction") or args.get("Description") or ""
        target_content = args.get("TargetContent") or ""
        replacement_content = args.get("ReplacementContent") or args.get("CodeContent") or ""
        return {
            "type": "edit",
            "label": f"● Edit({target})",
            "target": target,
            "raw_path": raw_path,
            "instruction": instruction,
            "target_content": target_content,
            "replacement_content": replacement_content,
            "is_file_edit": True,
            "name": name
        }
    elif name == "run_command":
        cmd = args.get("CommandLine") or args.get("cmd") or ""
        cmd_clean = clean_command_label(cmd)
        return {"type": "run", "label": f"● Run({cmd_clean})", "cmd": cmd, "cmd_clean": cmd_clean, "name": name}
    elif name == "search_web":
        q = args.get("query") or ""
        return {"type": "search", "label": f"● Search({q[:35]})", "query": q, "name": name}
    elif name in ("grep_search", "find_by_name"):
        q = args.get("query") or args.get("Pattern") or ""
        return {"type": "search", "label": f"● Grep({q[:35]})", "query": q, "name": name}
    elif name == "manage_task":
        act = (args.get("Action") or "").lower()
        # Filter out noisy polling tasks (status/list)
        if act in ("status", "list"):
            return None
        return {"type": "task", "label": f"● Task({act})", "action": act, "name": name}
    else:
        return {"type": "generic", "label": f"● {name}()", "name": name}

def get_conversation_messages(conv_id: str) -> List[Dict[str, Any]]:
    """
    Parse transcript.jsonl into clean, turn-based chat messages.
    Consolidates multiple intermediate steps into a single assistant response
    with thoughts and Antigravity TUI-style tool execution actions.
    """
    if not validate_conv_id(conv_id):
        return []

    conv_dir = (BRAIN_DIR / conv_id).resolve()
    transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    if not transcript_path.exists():
        return []

    messages = []
    current_user: Optional[str] = None
    current_assistant: str = ""
    current_thinking: List[str] = []
    current_tools: List[str] = []
    current_actions: List[Dict[str, str]] = []

    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    continue

                mtype = data.get("type")
                source = data.get("source")
                content = data.get("content", "")
                thinking = data.get("thinking", "")
                tool_calls = data.get("tool_calls", [])

                if mtype == "USER_INPUT" or source == "USER_EXPLICIT":
                    # Flush previous turn
                    if current_user is not None:
                        messages.append({"role": "user", "content": current_user})
                        if current_assistant or current_thinking or current_actions:
                            thinking_text = "\n\n".join(current_thinking).strip()
                            token_est = len(thinking_text.split()) * 2 if thinking_text else 0
                            messages.append({
                                "role": "assistant",
                                "content": current_assistant,
                                "thinking": thinking_text,
                                "thinking_tokens": token_est,
                                "tools": current_tools,
                                "actions": current_actions
                            })
                    current_user = clean_text(content)
                    current_assistant = ""
                    current_thinking = []
                    current_tools = []
                    current_actions = []

                else:
                    if thinking and thinking.strip():
                        current_thinking.append(thinking.strip())

                    # Record tool calls and formatted actions
                    if tool_calls and isinstance(tool_calls, list):
                        for tc in tool_calls:
                            name = tc.get("name", "tool")
                            args = tc.get("args", {})
                            if name not in current_tools:
                                current_tools.append(name)
                            action_item = format_tool_action(name, args)
                            if action_item:
                                current_actions.append(action_item)

                    elif mtype in ("GENERIC", "SYSTEM_MESSAGE") and current_actions:
                        # If the last action was a run action, attach output
                        last_action = current_actions[-1]
                        if last_action.get("type") == "run" and not last_action.get("output"):
                            out_clean = content.strip()
                            if "Output:\n" in out_clean:
                                out_clean = out_clean.split("Output:\n", 1)[1].strip()
                            elif "Stdout:\n" in out_clean:
                                out_clean = out_clean.split("Stdout:\n", 1)[1].strip()
                            if "\nLog:" in out_clean:
                                out_clean = out_clean.split("\nLog:", 1)[0].strip()
                            if out_clean:
                                last_action["output"] = out_clean[:4000]

                    cleaned = clean_text(content)
                    if cleaned and not is_internal_boilerplate(cleaned):
                        current_assistant = cleaned

        # Flush final turn
        if current_user is not None:
            messages.append({"role": "user", "content": current_user})
            if current_assistant or current_thinking or current_actions:
                thinking_text = "\n\n".join(current_thinking).strip()
                token_est = len(thinking_text.split()) * 2 if thinking_text else 0
                messages.append({
                    "role": "assistant",
                    "content": current_assistant or (f"*(총 {len(current_actions)}개 작업 수행 완료)*" if current_actions else ""),
                    "thinking": thinking_text,
                    "thinking_tokens": token_est,
                    "tools": current_tools,
                    "actions": current_actions
                })

    except Exception as e:
        print(f"Error parsing transcript for {conv_id}: {e}")

    return messages

def delete_conversation(conv_id: str) -> bool:
    """Delete a conversation folder if exists, with strict Path Traversal check."""
    if not validate_conv_id(conv_id):
        return False
    import shutil
    try:
        conv_dir = (BRAIN_DIR / conv_id).resolve()
        # Explicit double check
        conv_dir.relative_to(BRAIN_DIR.resolve())
        if conv_dir.exists() and conv_dir.is_dir():
            shutil.rmtree(conv_dir, ignore_errors=True)
            return True
    except (ValueError, RuntimeError):
        return False
    return False

def get_pending_action(conv_id: str) -> Optional[Dict[str, Any]]:
    """
    Detect if the conversation currently has a pending tool permission approval
    or ask_question input request waiting in the console / CLI.
    """
    if not validate_conv_id(conv_id):
        return None

    conv_dir = (BRAIN_DIR / conv_id).resolve()
    transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
    if not transcript_path.exists():
        return None

    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
            lines = [line.strip() for line in f if line.strip()]
    except Exception:
        return None

    if not lines:
        return None

    recent = []
    for line in lines[-20:]:
        try:
            recent.append(json.loads(line))
        except Exception:
            pass

    if not recent:
        return None

    planner_idx = -1
    for i in range(len(recent) - 1, -1, -1):
        if recent[i].get("type") == "PLANNER_RESPONSE":
            planner_idx = i
            break

    if planner_idx == -1:
        return None

    planner = recent[planner_idx]
    tool_calls = planner.get("tool_calls", [])
    if not tool_calls or not isinstance(tool_calls, list):
        return None

    after_planner = recent[planner_idx + 1:]
    if any(e.get("type") == "USER_INPUT" or e.get("source") == "USER_EXPLICIT" for e in after_planner):
        return None

    completed_tools_count = sum(1 for e in after_planner if e.get("type") in ("GENERIC", "TOOL_OUTPUT") and e.get("status") == "DONE")

    if completed_tools_count < len(tool_calls) or any(e.get("status") == "RUNNING" for e in after_planner):
        pending_tool_idx = min(completed_tools_count, len(tool_calls) - 1)
        pending_tool = tool_calls[pending_tool_idx]
        name = pending_tool.get("name", "tool")
        args = pending_tool.get("args", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                pass

        step_idx = planner.get("step_index", 0)
        action_id = f"act_{conv_id}_{step_idx}_{pending_tool_idx}"

        if name == "ask_question":
            raw_q = args.get("questions", [])
            if isinstance(raw_q, str):
                try:
                    raw_q = json.loads(raw_q)
                except Exception:
                    raw_q = []
            return {
                "type": "question",
                "name": name,
                "is_question": True,
                "action_id": action_id,
                "step_index": step_idx,
                "questions": raw_q
            }

        is_edit = name in ("replace_file_content", "write_to_file", "edit_file", "multi_replace_file_content")
        if is_edit:
            target_file = args.get("TargetFile") or args.get("AbsolutePath") or ""
            instruction = args.get("Instruction") or args.get("Description") or ""
            target_content = args.get("TargetContent") or ""
            replacement_content = args.get("ReplacementContent") or args.get("CodeContent") or ""
            return {
                "type": "file_approval",
                "name": name,
                "is_file_edit": True,
                "action_id": action_id,
                "step_index": step_idx,
                "target_file": target_file,
                "instruction": instruction,
                "target_content": target_content,
                "replacement_content": replacement_content,
                "args": args
            }

        cmd = args.get("CommandLine") or args.get("cmd") or ""
        return {
            "type": "tool_approval",
            "name": name,
            "is_file_edit": False,
            "action_id": action_id,
            "step_index": step_idx,
            "cmd": cmd,
            "args": args
        }

    return None

