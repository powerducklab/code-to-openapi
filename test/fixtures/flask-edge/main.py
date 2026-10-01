from flask import Flask

from api import bp, orphan

app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/v1")
