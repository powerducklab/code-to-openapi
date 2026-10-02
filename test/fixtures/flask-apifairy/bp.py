from flask import Blueprint

from schemas import UserSchema, UpdateUserSchema

users = Blueprint("users", __name__)

user_schema = UserSchema()
update_user_schema = UpdateUserSchema()


@users.route("/users/<int:id>", methods=["GET"])
@response(user_schema)
def get_user(id):
    return {}


@users.route("/users/<int:id>", methods=["PUT"])
@body(update_user_schema)
@response(user_schema)
@other_responses({404: "User not found"})
def put_user(id):
    return {}
