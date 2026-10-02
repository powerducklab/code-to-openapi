<?php

use App\Http\Controllers\Api\DataController;
use App\Http\Controllers\PageController;
use Illuminate\Support\Facades\Route;

Route::get('/page/show', [PageController::class, 'show']);
Route::get('/page/landing', [PageController::class, 'landing']);
Route::get('/page/home', [PageController::class, 'goHome']);
Route::get('/data/show', [DataController::class, 'show']);
Route::get('/data/error', [DataController::class, 'error']);
Route::get('/data/assigned', [DataController::class, 'assigned']);
