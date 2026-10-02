<?php

use App\Http\Controllers\AlbumController;
use App\Http\Controllers\AlbumSongController;
use App\Http\Controllers\OverviewController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::apiResource('albums', AlbumController::class);
    Route::apiResource('albums.songs', AlbumSongController::class);
    Route::get('/overview', OverviewController::class);
});
