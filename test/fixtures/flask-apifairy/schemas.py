# AST-only marshmallow schemas (no runtime imports required by the scanner).
# Base classes ending in `.Schema`/`Schema` are recognized; field types are read
# from the tail of the `ma.<Type>(...)` calls.

class UserSchema(ma.Schema):
    id = ma.Integer()
    username = ma.String(required=True)
    email = ma.String()


class UpdateUserSchema(UserSchema):
    old_password = ma.String(required=True)
