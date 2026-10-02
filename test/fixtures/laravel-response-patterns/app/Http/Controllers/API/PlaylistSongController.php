<?php

namespace App\Http\Controllers\API;

use App\Http\Resources\SongResource;
use Illuminate\Http\Resources\Json\ResourceCollection;
use Illuminate\Support\Collection;

class PlaylistSongController extends Controller
{
    public function index()
    {
        return self::createResourceCollection(collect());
    }

    public function store()
    {
        return self::createResourceCollection(collect());
    }

    private static function createResourceCollection(Collection $songs): ResourceCollection
    {
        return SongResource::collection($songs);
    }

    public function destroy()
    {
        return response()->noContent()->header('Authorization', 'refreshed');
    }
}
