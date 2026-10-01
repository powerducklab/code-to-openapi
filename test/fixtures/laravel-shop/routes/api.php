<?php

use App\Http\Controllers\Api\OrderController;
use App\Http\Controllers\Api\ProductController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->middleware('api')->group(function () {
    Route::get('/health', function () {
        return response()->json(['status' => 'ok']);
    });

    Route::prefix('admin')->group(function () {
        Route::get('/stats', [OrderController::class, 'stats']);
    });

    Route::apiResource('products', ProductController::class);
    Route::post('products/{product}/image', [ProductController::class, 'uploadImage']);
    Route::get('products/{product}/events', [ProductController::class, 'events']);

    Route::get('orders', [OrderController::class, 'index']);
    Route::get('orders/{order}', [OrderController::class, 'show']);
});
