<?php

use App\Http\Controllers\Api\AccessoryController;
use Illuminate\Support\Facades\Route;

Route::get('/accessories/{id}', [AccessoryController::class, 'show']);
Route::get('/accessories', [AccessoryController::class, 'list']);
Route::post('/accessories', [AccessoryController::class, 'store']);
