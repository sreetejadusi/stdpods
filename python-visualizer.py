import inspect
import io
import json
import sys
from typing import Any

USER_FILENAME = "<user_code>"
IGNORED_GLOBALS = {"__builtins__", "__name__", "__package__", "__doc__", "__annotations__"}


def is_primitive(value: Any) -> bool:
    return value is None or isinstance(value, (bool, int, float, str))


class HeapEncoder:
    def __init__(self) -> None:
        self.heap = {}
        self._seen = {}
        self._next_id = 1

    def encode(self, value: Any):
        if is_primitive(value):
            return value

        if inspect.isfunction(value):
            return ["FUNCTION", value.__name__]

        if inspect.ismodule(value):
            return ["MODULE", getattr(value, "__name__", repr(value))]

        object_id = id(value)

        if object_id in self._seen:
            return ["REF", self._seen[object_id]]

        heap_id = self._next_id
        self._next_id += 1
        self._seen[object_id] = heap_id

        if isinstance(value, list):
            self.heap[str(heap_id)] = ["LIST", *[self.encode(v) for v in value]]
            return ["REF", heap_id]

        if isinstance(value, tuple):
            self.heap[str(heap_id)] = ["TUPLE", *[self.encode(v) for v in value]]
            return ["REF", heap_id]

        if isinstance(value, set):
            ordered = sorted(list(value), key=lambda item: repr(item))
            self.heap[str(heap_id)] = ["SET", *[self.encode(v) for v in ordered]]
            return ["REF", heap_id]

        if isinstance(value, dict):
            items = []
            for key in sorted(value.keys(), key=lambda item: repr(item)):
                items.append([self.encode(key), self.encode(value[key])])
            self.heap[str(heap_id)] = ["DICT", *items]
            return ["REF", heap_id]

        if hasattr(value, "__dict__"):
            attributes = {}
            for key, item in sorted(vars(value).items()):
                attributes[key] = self.encode(item)
            self.heap[str(heap_id)] = ["INSTANCE", value.__class__.__name__, attributes]
            return ["REF", heap_id]

        self.heap[str(heap_id)] = ["PRIMITIVE", repr(value)]
        return ["REF", heap_id]


def should_trace(frame) -> bool:
    return frame.f_code.co_filename == USER_FILENAME


def encode_locals(frame, encoder: HeapEncoder):
    result = {}

    for key in sorted(frame.f_locals.keys()):
        if key in IGNORED_GLOBALS or key.startswith("__"):
            continue
        result[key] = encoder.encode(frame.f_locals[key])

    return result


def encode_globals(namespace, encoder: HeapEncoder):
    result = {}

    for key in sorted(namespace.keys()):
        if key in IGNORED_GLOBALS or key.startswith("__"):
            continue
        result[key] = encoder.encode(namespace[key])

    return result


def build_stack(frame, encoder: HeapEncoder):
    frames = []
    cursor = frame

    while cursor:
        if should_trace(cursor):
            frames.append(
                {
                    "func_name": cursor.f_code.co_name,
                    "line": cursor.f_lineno,
                    "locals": encode_locals(cursor, encoder),
                }
            )
        cursor = cursor.f_back

    frames.reverse()
    return frames


def make_snapshot(frame, event, arg, namespace, stdout_capture):
    encoder = HeapEncoder()
    snapshot = {
        "event": event,
        "line": frame.f_lineno if frame and should_trace(frame) else None,
        "globals": encode_globals(namespace, encoder),
        "stack": build_stack(frame, encoder),
        "memory": encoder.heap,
        "stdout": stdout_capture.getvalue(),
    }

    if event == "return":
        snapshot["return"] = encoder.encode(arg)

    if event == "exception" and arg:
        exc_type, exc_value, _ = arg
        snapshot["exception"] = {
            "type": getattr(exc_type, "__name__", str(exc_type)),
            "message": str(exc_value),
        }

    return snapshot


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    code = payload.get("code", "")
    stdin_text = payload.get("input", "")

    trace = []
    stdout_capture = io.StringIO()
    original_stdout = sys.stdout
    original_stdin = sys.stdin

    namespace = {
        "__name__": "__main__",
        "__package__": None,
        "__doc__": None,
        "__annotations__": {},
    }

    compiled = compile(code, USER_FILENAME, "exec")

    def tracer(frame, event, arg):
        if not should_trace(frame):
            return tracer

        if event in {"call", "line", "return", "exception"}:
            trace.append(make_snapshot(frame, event, arg, namespace, stdout_capture))

        return tracer

    try:
        sys.stdout = stdout_capture
        sys.stdin = io.StringIO(stdin_text)
        sys.settrace(tracer)
        exec(compiled, namespace, namespace)
    except BaseException as exc:
        trace.append(
            {
                "event": "uncaught_exception",
                "line": getattr(exc, "lineno", None),
                "globals": encode_globals(namespace, HeapEncoder()),
                "stack": [],
                "memory": {},
                "stdout": stdout_capture.getvalue(),
                "exception": {
                    "type": exc.__class__.__name__,
                    "message": str(exc),
                },
            }
        )
    finally:
        sys.settrace(None)
        sys.stdout = original_stdout
        sys.stdin = original_stdin

    print(json.dumps({"trace": trace, "stdout": stdout_capture.getvalue()}))


if __name__ == "__main__":
    main()
