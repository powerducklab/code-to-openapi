from rest_framework import serializers


class ProfileSerializer(serializers.Serializer):
    username = serializers.CharField()
    bio = serializers.CharField(allow_blank=True)
    image = serializers.URLField(required=False)
    following = serializers.BooleanField(read_only=True)


class CommentSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    body = serializers.CharField()
    author = ProfileSerializer(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class ArticleSerializer(serializers.Serializer):
    slug = serializers.SlugField(read_only=True)
    title = serializers.CharField()
    description = serializers.CharField()
    body = serializers.CharField()
    tag_list = serializers.ListField(child=serializers.CharField())
    author = ProfileSerializer(read_only=True)
    favorites_count = serializers.IntegerField(read_only=True)
    rating = serializers.SerializerMethodField()

    def get_rating(self, obj):
        return obj.cached_rating


class ArticleUpdateSerializer(serializers.Serializer):
    title = serializers.CharField(required=False)
    description = serializers.CharField(required=False)
    body = serializers.CharField(required=False)
