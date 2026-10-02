package main

import "github.com/gin-gonic/gin"

// Gin accepts route patterns with no leading slash ("favicon.ico"). The pack
// must normalize them to an absolute OpenAPI path key ("/favicon.ico") so the
// emitted document stays schema-valid.
func main() {
	r := gin.Default()
	r.GET("favicon.ico", func(c *gin.Context) {
		c.Data(200, "image/x-icon", nil)
	})
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true})
	})
	r.Run(":8099")
}
