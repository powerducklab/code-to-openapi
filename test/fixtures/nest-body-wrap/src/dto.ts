export interface CreateUserDto {
  email: string;
  password: string;
}

export interface UpdateUserDto {
  displayName?: string;
}
