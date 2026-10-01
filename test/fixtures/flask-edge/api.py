from flask import Blueprint, abort, jsonify, redirect, request, Response, stream_with_context

bp = Blueprint("api", __name__, url_prefix="/api")


@bp.get("/orders/<int:order_id>")
def get_order(order_id):
    tenant = request.headers.get("X-Tenant")
    session = request.cookies.get("session")
    if not tenant:
        abort(400)
    if order_id <= 0:
        abort(404)
    return jsonify({"id": order_id, "tenant": tenant, "session": session})


@bp.route("/orders", methods=["GET", "POST"])
def orders_collection():
    if request.method == "POST":
        payload = request.get_json()
        if not payload:
            abort(422)
        return jsonify({"created": True}), 201
    q = request.args.get("q")
    page = request.args["page"]
    return jsonify({"q": q, "page": page})


@bp.post("/orders/<int:order_id>/upload")
def upload_attachment(order_id):
    file = request.files["attachment"]
    category = request.form.get("category")
    return jsonify({"order": order_id, "category": category, "name": file.filename}), 202


@bp.get("/legacy/orders/<int:order_id>")
def legacy_redirect(order_id):
    return redirect(f"/api/orders/{order_id}", code=301)


@bp.get("/events/<uuid:stream_id>")
def events(stream_id):
    def generate():
        yield "event: tick\ndata: {}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
    )


@bp.get("/files/<path:subpath>")
def get_file(subpath):
    return Response("binary", mimetype="application/octet-stream")


orphan = Blueprint("orphan", __name__, url_prefix="/orphan")


@orphan.get("/lonely")
def lonely():
    return jsonify({})


class StorageClient:
    def get(self, key):
        return key

    def post(self, key, value):
        pass
