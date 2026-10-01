<?php

use App\Http\Controllers\InvoiceController;
use App\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

Route::group(['prefix' => 'api/v1'], function () {
    Route::get('/orders', function (\Illuminate\Http\Request $request) {
        $q = $request->query('q');
        $active = $request->boolean('active');
        $trace = $request->header('X-Trace');
        $session = $request->cookie('session');
        return response()->json(\App\Models\Order::all());
    });

    Route::post('/orders', function (\Illuminate\Http\Request $request) {
        $amount = $request->input('amount');
        $note = $request->input('note');
        return response()->json(\App\Models\Order::create($request->all()), 201);
    });

    Route::get('/orders/{id}', [OrderController::class, 'show']);
    Route::put('/orders/{id}', [OrderController::class, 'update']);
    Route::delete('/orders/{id}', [OrderController::class, 'destroy']);
    Route::get('/orders/{id}/receipt', [OrderController::class, 'receipt']);
    Route::get('/legacy/orders/{id}', function (string $id) {
        return redirect("/api/v1/orders/{$id}", 301);
    });
    Route::get('/events', [OrderController::class, 'events']);

    Route::apiResource('invoices', InvoiceController::class);
});
