package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Tag struct {
	Name string `json:"name"`
}

func GetTags(c *gin.Context) {
	c.JSON(http.StatusOK, []Tag{{Name: "go"}})
}
