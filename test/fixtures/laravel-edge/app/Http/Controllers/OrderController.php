<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateOrderRequest;
use App\Models\Order;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function show(string $id): Order
    {
        return Order::findOrFail($id);
    }

    public function update(string $id, UpdateOrderRequest $request): Order
    {
        $order = Order::findOrFail($id);
        $order->update($request->validated());
        return $order;
    }

    public function destroy(string $id): \Illuminate\Http\Response
    {
        return response()->noContent();
    }

    public function receipt(string $id): \Symfony\Component\HttpFoundation\BinaryFileResponse
    {
        return response()->download(storage_path("receipts/{$id}.pdf"));
    }

    public function events()
    {
        return response()->stream(function () {
            echo "data: ok\n\n";
        }, 200, [
            'Content-Type' => 'text/event-stream',
            'Cache-Control' => 'no-cache',
        ]);
    }
}
