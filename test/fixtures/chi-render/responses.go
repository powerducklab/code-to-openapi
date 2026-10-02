package main

import (
	"net/http"

	"github.com/go-chi/render"
)

// Article is the domain model embedded by the payloads below.
type Article struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type ArticleRequest struct {
	*Article
}

// ArticleResponse is the success payload. Its constructor returns the concrete
// struct pointer so the scanner can resolve the JSON schema.
type ArticleResponse struct {
	*Article
	Elapsed int64 `json:"elapsed"`
}

func NewArticleResponse(article *Article) *ArticleResponse {
	return &ArticleResponse{Article: article}
}

// NewArticleListResponse returns a slice of the render.Renderer interface. The
// scanner must follow the body to learn the concrete element type appended.
func NewArticleListResponse(articles []*Article) []render.Renderer {
	list := []render.Renderer{}
	for _, article := range articles {
		list = append(list, NewArticleResponse(article))
	}
	return list
}

// ErrResponse is the custom render.Renderer error type. Its constructor sets the
// HTTP status through the HTTPStatusCode field on the composite literal.
type ErrResponse struct {
	Err            error `json:"-"`
	HTTPStatusCode int   `json:"-"`

	StatusText string `json:"status"`
	ErrorText  string `json:"error,omitempty"`
}

func (e *ErrResponse) Render(w http.ResponseWriter, r *http.Request) error {
	render.Status(r, e.HTTPStatusCode)
	return nil
}

func ErrInvalidRequest(err error) render.Renderer {
	return &ErrResponse{
		Err:            err,
		HTTPStatusCode: 400,
		StatusText:     "Invalid request.",
	}
}

func ErrRender(err error) render.Renderer {
	return &ErrResponse{
		HTTPStatusCode: 422,
		StatusText:     "Error rendering response.",
	}
}

// ErrNotFound is a package-level render.Renderer value (a variable, not a func).
var ErrNotFound = &ErrResponse{HTTPStatusCode: 404, StatusText: "Resource not found."}
