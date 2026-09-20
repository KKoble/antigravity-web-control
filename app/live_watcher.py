import asyncio
from pathlib import Path
from typing import Dict, Set, List, Any
from fastapi import WebSocket
from app.config import BRAIN_DIR
from app.brain_service import get_conversation_messages, list_conversations, get_pending_action

class LiveWatcher:
    """
    Watches ~/.gemini/antigravity-cli/brain in real-time.
    Whenever CLI (agy) performs tasks, updates transcripts, or runs tools,
    it broadcasts the live changes directly to connected Web Control clients.
    """
    def __init__(self):
        self.subscribers: Dict[str, Set[WebSocket]] = {}
        self.global_subscribers: Set[WebSocket] = set()
        self.last_mtimes: Dict[str, float] = {}
        self.running = False
        self._task = None

    def subscribe(self, conv_id: str, ws: WebSocket):
        # Remove from previous specific conversation subscriptions
        for s in self.subscribers.values():
            s.discard(ws)
        if conv_id not in self.subscribers:
            self.subscribers[conv_id] = set()
        self.subscribers[conv_id].add(ws)

    def unsubscribe(self, conv_id: str, ws: WebSocket):
        if conv_id in self.subscribers:
            self.subscribers[conv_id].discard(ws)

    def subscribe_global(self, ws: WebSocket):
        self.global_subscribers.add(ws)

    def unsubscribe_all(self, ws: WebSocket):
        self.global_subscribers.discard(ws)
        for s in self.subscribers.values():
            s.discard(ws)

    async def start(self):
        if self._task is None or self._task.done():
            self.running = True
            self._task = asyncio.create_task(self._watch_loop())

    async def stop(self):
        self.running = False
        if self._task and not self._task.done():
            self._task.cancel()

    async def _watch_loop(self):
        # Initialize mtimes
        self._scan_initial_mtimes()
        while self.running:
            try:
                await self._check_updates()
            except asyncio.CancelledError:
                break
            except Exception as e:
                pass
            await asyncio.sleep(0.8)

    def _scan_initial_mtimes(self):
        if not BRAIN_DIR.exists():
            return
        for entry in BRAIN_DIR.iterdir():
            if entry.is_dir() and not entry.name.startswith("."):
                t_path = entry / ".system_generated" / "logs" / "transcript.jsonl"
                if t_path.exists():
                    try:
                        self.last_mtimes[entry.name] = t_path.stat().st_mtime
                    except Exception:
                        pass

    async def _check_updates(self):
        if not BRAIN_DIR.exists():
            return

        has_any_change = False
        changed_convs = []

        for entry in BRAIN_DIR.iterdir():
            if not entry.is_dir() or entry.name.startswith("."):
                continue

            conv_id = entry.name
            t_path = entry / ".system_generated" / "logs" / "transcript.jsonl"
            if not t_path.exists():
                continue

            try:
                current_mtime = t_path.stat().st_mtime
            except Exception:
                continue

            prev_mtime = self.last_mtimes.get(conv_id, 0)
            if current_mtime > prev_mtime:
                self.last_mtimes[conv_id] = current_mtime
                has_any_change = True
                changed_convs.append(conv_id)

                # If any clients are actively watching this conversation, push new messages
                messages = get_conversation_messages(conv_id)
                pending_action = get_pending_action(conv_id)
                if conv_id in self.subscribers and self.subscribers[conv_id]:
                    dead_sockets = set()
                    for ws in list(self.subscribers[conv_id]):
                        try:
                            await ws.send_json({
                                "type": "cli_live_sync",
                                "conversation_id": conv_id,
                                "messages": messages,
                                "pending_action": pending_action
                            })
                        except Exception:
                            dead_sockets.add(ws)
                    self.subscribers[conv_id].difference_update(dead_sockets)

        # If any conversation changed or was created in CLI, notify sidebar and check for pending actions
        if has_any_change and self.global_subscribers:
            latest_id = changed_convs[0] if changed_convs else None
            latest_pending = get_pending_action(latest_id) if latest_id else None
            dead_globals = set()
            for ws in list(self.global_subscribers):
                try:
                    await ws.send_json({
                        "type": "cli_conversations_updated",
                        "changed_conversations": changed_convs,
                        "latest_conv_id": latest_id,
                        "pending_action": latest_pending
                    })
                except Exception:
                    dead_globals.add(ws)
            self.global_subscribers.difference_update(dead_globals)

live_watcher = LiveWatcher()
