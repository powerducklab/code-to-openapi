export interface User {
  id: string;
  name: string;
  email: string;
}

export interface UserDetail extends User {
  createdAt: string;
}

export interface Order {
  id: string;
  total: number;
  currency?: string;
}

export interface ErrorBody {
  message: string;
}
