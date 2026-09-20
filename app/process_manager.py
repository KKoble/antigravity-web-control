import asyncio
import logging
from typing import Dict, Set, Any, Optional

logger = logging.getLogger("process_manager")

# Active agy streaming processes spawned by chat WebSocket connections
active_stream_processes: Dict[str, asyncio.subprocess.Process] = {}

# Active ConPTY / PTY terminal processes (Web Terminal)
active_pty_sessions: Set[Any] = set()

def register_stream_process(conn_id: str, proc: asyncio.subprocess.Process):
    active_stream_processes[conn_id] = proc
    logger.info(f"Registered stream process for {conn_id} (pid={getattr(proc, 'pid', None)})")

def unregister_stream_process(conn_id: str):
    active_stream_processes.pop(conn_id, None)

def register_pty(pty_proc: Any):
    active_pty_sessions.add(pty_proc)
    logger.info(f"Registered active PTY session (total: {len(active_pty_sessions)})")

def unregister_pty(pty_proc: Any):
    active_pty_sessions.discard(pty_proc)

def broadcast_terminal_input(input_data: str) -> int:
    """Send keystrokes / text directly to all active Web Terminal PTY sessions."""
    dead_sessions = set()
    delivered = 0
    for pty in list(active_pty_sessions):
        try:
            if hasattr(pty, "isalive") and not pty.isalive():
                dead_sessions.add(pty)
                continue
            pty.write(input_data)
            delivered += 1
        except Exception as e:
            logger.warning(f"Error writing to PTY: {e}")
            dead_sessions.add(pty)
    active_pty_sessions.difference_update(dead_sessions)
    return delivered

async def send_approval(approved: bool, conn_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Approve (y) or reject (n) across both:
    1) Background agy stream processes
    2) Active Web Terminal PTY sessions
    """
    reply_str = "y\r\n" if approved else "n\r\n"
    reply_bytes = b"y\n" if approved else b"n\n"

    stream_delivered = 0
    # If specific connection ID provided, deliver to it first
    target_procs = [active_stream_processes[conn_id]] if (conn_id and conn_id in active_stream_processes) else list(active_stream_processes.values())

    for proc in target_procs:
        try:
            if proc and proc.stdin and not proc.stdin.is_closing():
                proc.stdin.write(reply_bytes)
                await proc.stdin.drain()
                stream_delivered += 1
        except Exception as e:
            logger.warning(f"Error writing approval to proc stdin: {e}")

    pty_delivered = broadcast_terminal_input(reply_str)
    return {
        "ok": True,
        "approved": approved,
        "stream_delivered": stream_delivered,
        "pty_delivered": pty_delivered
    }

async def send_question_answer(answer: str, option_num: Optional[int] = None, conn_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Deliver question answer / option number to stream processes and PTY sessions.
    """
    val = f"{option_num}\r\n" if option_num else f"{answer}\r\n"
    val_bytes = val.encode("utf-8")

    stream_delivered = 0
    target_procs = [active_stream_processes[conn_id]] if (conn_id and conn_id in active_stream_processes) else list(active_stream_processes.values())

    for proc in target_procs:
        try:
            if proc and proc.stdin and not proc.stdin.is_closing():
                proc.stdin.write(val_bytes)
                await proc.stdin.drain()
                stream_delivered += 1
        except Exception as e:
            logger.warning(f"Error writing answer to proc stdin: {e}")

    pty_delivered = broadcast_terminal_input(val)
    return {
        "ok": True,
        "answer": answer,
        "option_num": option_num,
        "stream_delivered": stream_delivered,
        "pty_delivered": pty_delivered
    }
