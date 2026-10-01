<?php

namespace App\Http\Controllers\Api;

use App\Http\Resources\OrderResource;
use App\Models\Order;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function index(): \Illuminate\Http\Resources\Json\AnonymousResourceCollection
    {
        return OrderResource::collection(Order::all());
    }

    public function show(Order $order): OrderResource
    {
        return new OrderResource($order);
    }

    public function stats(Request $request): \Illuminate\Http\JsonResponse
    {
        $status = $request->get('status', 'paid');
        return response()->json(['status' => $status, 'count' => Order::where('status', $status)->count()]);
    }
}
