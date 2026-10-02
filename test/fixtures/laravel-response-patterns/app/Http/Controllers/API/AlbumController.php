<?php

namespace App\Http\Controllers\API;

use App\Http\Resources\SongResource;

class AlbumController extends Controller
{
    public function index()
    {
        return SongResource::collection(collect());
    }

    public function show(string $album)
    {
        return SongResource::make(['id' => 1]);
    }

    public function update(string $album)
    {
        return response()->noContent();
    }
}
