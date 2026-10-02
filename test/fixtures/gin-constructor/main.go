package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

var users []*User

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)
	r.GET("/users/:id", getUser)
	r.POST("/users", createUser)
	r.Run(":8091")
}

func listUsers(c *gin.Context) {
	c.JSON(http.StatusOK, NewUsersResponse(users))
}

func getUser(c *gin.Context) {
	c.JSON(http.StatusOK, NewUserResponse(users[0]))
}

func createUser(c *gin.Context) {
	c.JSON(http.StatusCreated, NewUserResponse(users[0]))
}
