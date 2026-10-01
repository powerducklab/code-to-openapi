package main

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type Category struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type Item struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Price     float64   `json:"price"`
	Tags      []string  `json:"tags"`
	Category  *Category `json:"category,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type DecoyClient struct{}

func (d *DecoyClient) GET(path string) {}

type ListItemsQuery struct {
	Limit int    `form:"limit"`
	Q     string `form:"q"`
}

func ListItems(c *gin.Context) {
	var query ListItemsQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, []*Item{})
}

func CreateItem(c *gin.Context) {
	var input Item
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	c.JSON(http.StatusCreated, input)
}

func GetItem(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.Status(http.StatusNotFound)
		return
	}
	c.JSON(http.StatusOK, &Item{})
}

func DeleteItem(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func Stream(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Stream(func(w interface{}) bool {
		c.SSEvent("ping", gin.H{"ts": time.Now().Unix()})
		return false
	})
}
