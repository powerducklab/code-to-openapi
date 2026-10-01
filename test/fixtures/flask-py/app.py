import json

from flask import Blueprint, Flask, Response, abort, jsonify, request, stream_with_context

app = Flask(__name__)
bp = Blueprint("users", __name__, url_prefix="/users")


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@bp.route("/<int:uid>", methods=["GET"])
def get_user(uid):
    expand = request.args.get("expand")
    trace = request.headers.get("X-Trace")
    return jsonify({"id": uid, "name": "demo", "expand": expand}), 200


@bp.post("/")
def create_user():
    payload = request.get_json(force=True)
    if not payload:
        abort(400)
    return jsonify({"created": True}), 201


@app.route("/upload", methods=["POST"])
def upload():
    files = request.files
    return jsonify({"received": len(files)}), 202


@app.get("/stream")
def stream():
    def generate():
        yield "data: ping\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


app.register_blueprint(bp, url_prefix="/api")

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050)
