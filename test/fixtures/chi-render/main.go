package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/render"
)

var articles []*Article

func main() {
	r := chi.NewRouter()
	r.Get("/articles", ListArticles)
	r.Post("/articles", CreateArticle)
	r.Get("/articles/{articleID}", GetArticle)
	r.Delete("/articles/{articleID}", DeleteArticle)
	http.ListenAndServe(":8090", r)
}

func ListArticles(w http.ResponseWriter, r *http.Request) {
	if err := render.RenderList(w, r, NewArticleListResponse(articles)); err != nil {
		render.Render(w, r, ErrRender(err))
		return
	}
}

func CreateArticle(w http.ResponseWriter, r *http.Request) {
	data := &ArticleRequest{}
	if err := render.Bind(r, data); err != nil {
		render.Render(w, r, ErrInvalidRequest(err))
		return
	}
	render.Status(r, http.StatusCreated)
	render.Render(w, r, NewArticleResponse(data.Article))
}

func GetArticle(w http.ResponseWriter, r *http.Request) {
	render.Render(w, r, NewArticleResponse(articles[0]))
}

func DeleteArticle(w http.ResponseWriter, r *http.Request) {
	if chi.URLParam(r, "articleID") == "" {
		render.Render(w, r, ErrNotFound)
		return
	}
	render.Render(w, r, NewArticleResponse(articles[0]))
}
