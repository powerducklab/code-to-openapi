package main

import (
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type ArticleFilter struct {
	Tag    string `form:"tag" binding:"required"`
	Limit  int    `form:"limit"`
	Offset int    `form:"offset"`
}

type Article struct {
	ID    int      `json:"id"`
	Title string   `json:"title"`
	Tags  []string `json:"tags"`
}

type ArticleInput struct {
	Title string   `json:"title" binding:"required"`
	Tags  []string `json:"tags"`
}

type ErrorBody struct {
	Error string `json:"error"`
}

func authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("Authorization")
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, ErrorBody{Error: "missing token"})
			return
		}
		c.Next()
	}
}

func listArticles(c *gin.Context) {
	var filter ArticleFilter
	if err := c.ShouldBindQuery(&filter); err != nil {
		c.JSON(http.StatusBadRequest, ErrorBody{Error: "bad filter"})
		return
	}
	trace := c.GetHeader("X-Trace")
	session, _ := c.Cookie("session")
	c.JSON(http.StatusOK, gin.H{"tag": filter.Tag, "trace": trace, "session": session})
}

func createArticle(c *gin.Context) {
	var input ArticleInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusUnprocessableEntity, ErrorBody{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, Article{ID: 1, Title: input.Title, Tags: input.Tags})
}

func getArticle(c *gin.Context) {
	id := c.Param("id")
	if id == "0" {
		c.AbortWithStatusJSON(http.StatusNotFound, ErrorBody{Error: "missing"})
		return
	}
	c.JSON(http.StatusOK, Article{ID: 1, Title: "demo"})
}

func deleteArticle(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func oldArticle(c *gin.Context) {
	c.Redirect(http.StatusFound, "/articles")
}

func downloadReport(c *gin.Context) {
	c.Data(http.StatusOK, "application/pdf", []byte{1, 2, 3})
}

func streamEvents(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Stream(func(w io.Writer) bool {
		c.SSEvent("tick", gin.H{"ts": time.Now().Unix()})
		return false
	})
}

type MetricsClient struct {
}

func (m *MetricsClient) Get(key string) string { return key }
func (m *MetricsClient) Post(key string)       {}

func main() {
	r := gin.Default()
	v1 := r.Group("/v1")
	{
		articles := v1.Group("/articles")
		{
			articles.GET("", listArticles)
			articles.POST("", authMiddleware(), createArticle)
			articles.GET("/:id", getArticle)
			articles.DELETE("/:id", deleteArticle)
			articles.GET("/old/:id", oldArticle)
		}
		v1.GET("/reports/:name", downloadReport)
		v1.GET("/events", streamEvents)
	}
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	r.Run(":8091")
}
