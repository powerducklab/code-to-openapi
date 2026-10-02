export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserInput {
  name: string;
  email: string;
}

export interface ErrorBody {
  message: string;
}

export interface OrderEvent {
  id: string;
  type: string;
}
