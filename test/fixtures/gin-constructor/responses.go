package main

// User is the domain model wrapped by the response payloads.
type User struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// UserResponse is the payload returned by NewUserResponse.
type UserResponse struct {
	User *User  `json:"user"`
	Role string `json:"role"`
}

func NewUserResponse(u *User) *UserResponse {
	return &UserResponse{User: u, Role: "member"}
}

// UsersResponse wraps a page of user payloads.
type UsersResponse struct {
	Items []*UserResponse `json:"items"`
	Total int             `json:"total"`
}

func NewUsersResponse(users []*User) *UsersResponse {
	return &UsersResponse{Total: len(users)}
}
