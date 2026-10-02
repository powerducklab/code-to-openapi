from flask import Flask


# A real app-factory with function-level imports. The blueprint must still be
# discovered: the import lives inside create_app, and registration happens
# against the app instance created here.
def create_app():
    app = Flask(__name__)
    from bp import users

    app.register_blueprint(users, url_prefix="/api")
    return app
