from pytutor import pg_logger
import sys, json

code = sys.stdin.read()

trace = pg_logger.exec_script_str(code, cumulative_mode=False)

print(json.dumps(trace))
