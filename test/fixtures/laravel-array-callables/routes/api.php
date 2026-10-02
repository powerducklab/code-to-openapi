<?php

use App\Http\Controllers\Api;
use App\Http\Controllers\Catalog\ProductController;
use Illuminate\Support\Facades\Route;

Route::get('/orders', [Api\OrderController::class, 'index']);

Route::resource('/products', ProductController::class);
