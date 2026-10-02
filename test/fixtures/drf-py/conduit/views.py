from rest_framework import viewsets, parsers
from rest_framework.decorators import action, api_view
from rest_framework.generics import GenericAPIView
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .serializers import (
    ArticleSerializer,
    ArticleUpdateSerializer,
    CommentSerializer,
    ProfileSerializer,
)


class StandardPagination(PageNumberPagination):
    page_size = 20


class ArticleViewSet(viewsets.ModelViewSet):
    serializer_class = ArticleSerializer
    pagination_class = StandardPagination
    permission_classes = [IsAuthenticated]
    parser_classes = [parsers.JSONParser, parsers.MultiPartParser]

    @action(detail=True, methods=["POST"])
    def favorite(self, request, pk=None):
        return Response({"favorited": True})

    @action(detail=True, methods=["DELETE"])
    def unfavorite(self, request, pk=None):
        return Response({"favorited": False})

    @action(detail=False, methods=["GET"])
    def feed(self, request):
        return Response([])


class CommentViewSet(viewsets.GenericViewSet):
    serializer_class = CommentSerializer
    pagination_class = None

    def list(self, request, article_slug=None):
        return Response(self.get_serializer(self.get_queryset(), many=True).data)

    def create(self, request, article_slug=None):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(serializer.data, status=201)


class HealthView(APIView):
    """Plain APIView wired through Django urlpatterns."""

    permission_classes = []

    def get(self, request):
        return Response({"status": "ok"})

    def delete(self, request):
        return Response(status=204)


class DraftViewSet(viewsets.ViewSet):
    """get_serializer_class() overridden with no static serializer_class:
    request/response shapes are a dynamic, honest gap."""

    def get_serializer_class(self):
        return ArticleUpdateSerializer if self.action == "update" else ArticleSerializer

    def list(self, request):
        return Response([])

    def create(self, request):
        return Response({}, status=201)


class EchoView(GenericAPIView):
    serializer_class = ProfileSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(serializer.data)


@api_view(["GET", "POST"])
def ping(request):
    if request.method == "POST":
        return Response({"pong": "posted"})
    return Response({"pong": True})


@api_view(["GET"])
def profile_detail(request, username):
    return Response(ProfileSerializer().data)
