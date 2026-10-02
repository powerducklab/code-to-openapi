from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter, SimpleRouter

from . import views

app_name = "conduit"

router = DefaultRouter()
router.register(r"articles", views.ArticleViewSet, basename="article")
router.register(
    r"articles/(?P<article_slug>[\w-]+)/comments",
    views.CommentViewSet,
    basename="article-comments",
)
router.register(r"drafts", views.DraftViewSet, basename="draft")

legacy = SimpleRouter()

urlpatterns = [
    path("health/", views.HealthView.as_view()),
    path("echo/", views.EchoView.as_view()),
    path("ping/", views.ping),
    re_path(r"profiles/(?P<username>[\w.@+-]+)/$", views.profile_detail),
    path("api/", include(router.urls)),
]
