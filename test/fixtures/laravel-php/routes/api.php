<?php

use App\Http\Controllers\UserController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);

Route::group(['prefix' => 'api'], function () {
    Route::get('/users/{id}', [UserController::class, 'show']);
    Route::delete('/users/{id}', [UserController::class, 'destroy']);

    Route::get('/search', function (Request $request) {
        $q = $request->query('q');
        return response()->json(['results' => []]);
    });

    Route::get('/events', function () {
        return response()->stream(function () {
            echo "data: hello\n\n";
            ob_flush();
            flush();
        }, 200, ['Content-Type' => 'text/event-stream']);
    });
});

Route::apiResource('/posts', PostController::class);
