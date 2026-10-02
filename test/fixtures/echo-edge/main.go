package main

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

type Item struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Price float64 `json:"price"`
}

type ItemInput struct {
	Name  string `json:"name"`
	Price float64 `json:"price"`
}

type ErrBody struct {
	Error string `json:"error"`
}

func listItems(c echo.Context) error {
	tag := c.QueryParam("tag")
	trace := c.Request().Header.Get("X-Trace")
	_ = tag
	_ = trace
	return c.JSON(http.StatusOK, []Item{{ID: "1", Name: "cup", Price: 9.5}})
}

func createItem(c echo.Context) error {
	in := new(ItemInput)
	if err := c.Bind(in); err != nil {
		return c.JSON(http.StatusBadRequest, ErrBody{Error: "bad body"})
	}
	return c.JSON(http.StatusCreated, Item{ID: "2", Name: in.Name, Price: in.Price})
}

func getItem(c echo.Context) error {
	id := c.Param("id")
	if id == "0" {
		return c.JSON(http.StatusNotFound, ErrBody{Error: "missing"})
	}
	return c.JSON(http.StatusOK, Item{ID: id, Name: "cup"})
}

func main() {
	e := echo.New()
	e.GET("/items", listItems)
	e.POST("/items", createItem)

	g := e.Group("/api")
	g.GET("/items/:id", getItem)

	e.Logger.Fatal(e.Start(":8095"))
}
