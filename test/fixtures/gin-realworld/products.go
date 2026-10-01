package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Category struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type Base struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
}

type Product struct {
	Base
	Name     string    `json:"name"`
	Price    float64   `json:"price"`
	Tags     []string  `json:"tags"`
	Category *Category `json:"category,omitempty"`
}

type ProductResponse struct {
	Code    int     `json:"code"`
	Message string  `json:"message"`
	Data    Product `json:"data"`
}

type PageResult struct {
	Items   []Product `json:"items"`
	Page    int       `json:"page"`
	PerPage int       `json:"per_page"`
	Total   int64     `json:"total"`
}

type ProductPageResponse struct {
	Code    int        `json:"code"`
	Message string     `json:"message"`
	Data    PageResult `json:"data"`
}

type ListProductsQuery struct {
	Page    int    `form:"page" binding:"required"`
	Keyword string `form:"keyword"`
}

type ProductURI struct {
	ID string `uri:"id" binding:"required"`
}

type CreateProductBody struct {
	Name  string  `json:"name" binding:"required"`
	Price float64 `json:"price" binding:"required"`
}

func registerProductRoutes(api *gin.RouterGroup) {
	api.GET("/products/:id", func(c *gin.Context) {
		var uri ProductURI
		if err := c.ShouldBindUri(&uri); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, ProductResponse{Code: 0, Message: "ok", Data: Product{Base: Base{ID: uri.ID}, Name: "hammer", Price: 9.99}})
	})

	api.GET("/products", func(c *gin.Context) {
		var query ListProductsQuery
		if err := c.ShouldBindQuery(&query); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, ProductPageResponse{Code: 0, Message: "ok", Data: PageResult{Page: query.Page, PerPage: 20}})
	})

	api.POST("/products", func(c *gin.Context) {
		var body CreateProductBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		c.JSON(http.StatusCreated, ProductResponse{Code: 0, Message: "created", Data: Product{Name: body.Name, Price: body.Price}})
	})
}
