from flask import Flask, Blueprint
from flask_restful import Api, Resource

app = Flask(__name__)

users_bp = Blueprint("users", __name__, url_prefix="/api")
bp_api = Api(users_bp)
app.register_blueprint(users_bp)


class Hello(Resource):
    def get(self):
        return {"hello": "world"}

    def post(self):
        return {"ok": True}


class Item(Resource):
    def get(self, item_id):
        return {"id": item_id}

    def delete(self, item_id):
        return "", 204


api = Api(app)
api.add_resource(Hello, "/hello")
api.add_resource(Item, "/items/<int:item_id>")


class Profile(Resource):
    def get(self, user_id):
        return {"user": user_id}


bp_api.add_resource(Profile, "/profiles/<user_id>")
