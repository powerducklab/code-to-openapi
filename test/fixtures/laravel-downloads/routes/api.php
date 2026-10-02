<?php

use App\Http\Controllers\DownloadController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::get('helper-download', [DownloadController::class, 'helperDownload']);
    Route::get('facade-make', [DownloadController::class, 'facadeMake']);
    Route::get('facade-download', [DownloadController::class, 'facadeDownload']);
    Route::get('facade-stream', [DownloadController::class, 'facadeStream']);
    Route::get('helper-stream', [DownloadController::class, 'helperStream']);
    Route::get('file', [DownloadController::class, 'file']);
    Route::get('make', [DownloadController::class, 'make']);
    Route::get('binary-file', [DownloadController::class, 'binaryFile']);
    Route::get('streamed', [DownloadController::class, 'streamed']);
    Route::get('via-base-helper', [DownloadController::class, 'viaBaseHelper']);
});
