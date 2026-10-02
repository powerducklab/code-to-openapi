<?php

use App\Http\Controllers\CatalogController;
use Illuminate\Support\Facades\Route;

Route::controller(CatalogController::class)->prefix('catalog')->group(function () {
    Route::get('', 'index');
    Route::get('{id}', 'show');
});
