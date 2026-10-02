package main

import (
	"net/http"

	"github.com/gofiber/fiber/v2"
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

func listItems(c *fiber.Ctx) error {
	tag := c.Query("tag")
	trace := c.Get("X-Trace")
	_ = tag
	_ = trace
	return c.JSON([]Item{{ID: "1", Name: "cup", Price: 9.5}})
}

func createItem(c *fiber.Ctx) error {
	in := new(ItemInput)
	if err := c.BodyParser(in); err != nil {
		return c.Status(http.StatusBadRequest).JSON(ErrBody{Error: "bad body"})
	}
	return c.Status(http.StatusCreated).JSON(Item{ID: "2", Name: in.Name, Price: in.Price})
}

func getItem(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "0" {
		return c.Status(http.StatusNotFound).JSON(ErrBody{Error: "missing"})
	}
	return c.JSON(Item{ID: id, Name: "cup"})
}

func main() {
	app := fiber.New()
	app.Get("/items", listItems)
	app.Post("/items", createItem)

	grp := app.Group("/api")
	grp.Get("/items/:id", getItem)

	app.Listen(":8096")
}
