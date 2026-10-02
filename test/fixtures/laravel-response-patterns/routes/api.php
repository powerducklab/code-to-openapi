<?php

use App\Http\Controllers\API\AlbumController;
use App\Http\Controllers\API\Auth\TwoFactor\EnrollController as EnrollTwoFactorController;
use App\Http\Controllers\API\FavoriteController;
use App\Http\Controllers\API\PlaylistSongController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::get('ping', fn () => null);
    Route::get('home', fn () => response()->json(['ok' => true]));
    Route::get('page', fn () => view('home'));

    Route::post('me/two-factor', EnrollTwoFactorController::class);

    Route::get('playlists/{playlist}/songs', [PlaylistSongController::class, 'index']);
    Route::post('playlists/{playlist}/songs', [PlaylistSongController::class, 'store']);
    Route::delete('playlists/{playlist}/songs', [PlaylistSongController::class, 'destroy']);

    Route::get('favorites/toggle', [FavoriteController::class, 'toggle']);
    Route::get('favorites/scoped', [FavoriteController::class, 'scoped']);
    Route::get('favorites/array', [FavoriteController::class, 'bareArray']);
    Route::get('favorites/matched', [FavoriteController::class, 'matched']);
    Route::get('favorites/redirected', [FavoriteController::class, 'redirected']);

    // Only index/show/update are implemented; store/destroy must not appear.
    Route::apiResource('albums', AlbumController::class)->only(['index', 'show', 'update']);
});
