"""Hermes -> Synth Temporal bridge adapter.

This module keeps Hermes' agent loop intact. Inference is configured by pointing
Hermes' custom OpenAI-compatible provider at the Synth bridge /v1 endpoint.
Registry-dispatched tools are routed through Temporal and then loop back into the
original Hermes dispatcher. Agent-local tools (todo, memory, session_search,
clarify, delegate_task) intentionally remain local to Hermes.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

_AGENT_LOCAL_TOOLS = {"todo", "memory", "session_search", "clarify", "delegate_task"}


class HermesTemporalBridge:
    def __init__(
        self,
        bridge_url: str,
        *,
        agent_id: str = "hermes",
        bearer_token: Optional[str] = None,
        callback_host: str = "127.0.0.1",
        callback_port: int = 8791,
        callback_url: Optional[str] = None,
        callback_bearer_token: Optional[str] = None,
    ) -> None:
        self.bridge_url = bridge_url.rstrip("/")
        self.agent_id = agent_id
        self.bearer_token = bearer_token
        self.callback_host = callback_host
        self.callback_port = callback_port
        self.callback_url = callback_url or f"http://{callback_host}:{callback_port}/execute"
        self.callback_bearer_token = callback_bearer_token
        self._original_dispatch: Optional[Callable[..., str]] = None
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    def _post_json(self, path: str, body: dict[str, Any]) -> Any:
        headers = {"content-type": "application/json"}
        if self.bearer_token:
            headers["authorization"] = f"Bearer {self.bearer_token}"
        request = urllib.request.Request(
            f"{self.bridge_url}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60 * 30) as response:
            return json.loads(response.read().decode("utf-8"))

    def dispatch(
        self,
        function_name: str,
        function_args: dict[str, Any],
        task_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        session_id: Optional[str] = None,
        user_task: Optional[str] = None,
        enabled_tools: Optional[list[str]] = None,
    ) -> str:
        if function_name in _AGENT_LOCAL_TOOLS:
            assert self._original_dispatch is not None
            return self._original_dispatch(
                function_name,
                function_args,
                task_id,
                tool_call_id=tool_call_id,
                session_id=session_id,
                user_task=user_task,
                enabled_tools=enabled_tools,
            )

        stable_tool_call_id = tool_call_id or (
            f"{task_id or 'default'}:{function_name}:"
            f"{json.dumps(function_args, sort_keys=True)}"
        )
        response = self._post_json(
            "/v1/synth/tools/execute",
            {
                "agentId": self.agent_id,
                "sessionId": session_id or task_id or self.agent_id,
                "toolCallId": stable_tool_call_id,
                "toolName": function_name,
                "arguments": function_args,
                "callbackUrl": self.callback_url,
                "metadata": {
                    "taskId": task_id or "",
                    "sessionId": session_id or "",
                    "userTask": user_task,
                    "enabledTools": enabled_tools,
                },
            },
        )
        result = response.get("result")
        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)

    def _make_handler(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if (
                    bridge.callback_bearer_token
                    and self.headers.get("authorization")
                    != f"Bearer {bridge.callback_bearer_token}"
                ):
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.path != "/execute":
                    self.send_error(404)
                    return
                try:
                    size = int(self.headers.get("content-length", "0"))
                    body = json.loads(self.rfile.read(size) or b"{}")
                    metadata = body.get("metadata") or {}
                    assert bridge._original_dispatch is not None
                    result = bridge._original_dispatch(
                        body["toolName"],
                        body.get("arguments") or {},
                        metadata.get("taskId") or None,
                        tool_call_id=body.get("toolCallId"),
                        session_id=metadata.get("sessionId") or None,
                        user_task=metadata.get("userTask"),
                        enabled_tools=metadata.get("enabledTools"),
                    )
                    payload = json.dumps({"result": result}, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except Exception as exc:
                    payload = json.dumps({"error": str(exc)}).encode("utf-8")
                    self.send_response(500)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

            def log_message(self, _format: str, *_args: Any) -> None:
                return

        return Handler

    def install(self) -> None:
        import model_tools
        import run_agent

        if self._original_dispatch is not None:
            return
        self._original_dispatch = model_tools.handle_function_call

        self._server = ThreadingHTTPServer(
            (self.callback_host, self.callback_port),
            self._make_handler(),
        )
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

        model_tools.handle_function_call = self.dispatch
        # run_agent imports handle_function_call directly, so patch that bound symbol too.
        run_agent.handle_function_call = self.dispatch

        # Optional Hermes surfaces also import the dispatcher directly. Patch only
        # modules already loaded; future imports will see model_tools patched.
        for module_name in ("environments.tool_context", "environments.agent_loop"):
            module = sys.modules.get(module_name)
            if module is not None:
                setattr(module, "handle_function_call", self.dispatch)

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        self._server = None
        self._thread = None


def install_from_env() -> HermesTemporalBridge:
    bridge = HermesTemporalBridge(
        os.environ.get("SYNTH_TEMPORAL_BRIDGE_URL", "http://127.0.0.1:8788"),
        agent_id=os.environ.get("SYNTH_AGENT_ID", "hermes"),
        bearer_token=os.environ.get("SYNTH_TEMPORAL_BRIDGE_TOKEN") or None,
        callback_host=os.environ.get("SYNTH_HERMES_CALLBACK_HOST", "127.0.0.1"),
        callback_port=int(os.environ.get("SYNTH_HERMES_CALLBACK_PORT", "8791")),
        callback_url=os.environ.get("SYNTH_HERMES_CALLBACK_URL") or None,
        callback_bearer_token=os.environ.get("SYNTH_TOOL_CALLBACK_TOKEN") or None,
    )
    bridge.install()
    return bridge
