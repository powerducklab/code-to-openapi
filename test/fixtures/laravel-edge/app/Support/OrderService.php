<?php

namespace App\Support;

use App\Models\Order;

class OrderService
{
    public function get(string $id): ?Order
    {
        return Order::find($id);
    }

    public function post(array $attributes): Order
    {
        return Order::create($attributes);
    }

    public function delete(string $id): void
    {
        Order::destroy($id);
    }
}
