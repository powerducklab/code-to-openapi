<?php

namespace App\Http\Controllers\API;

use App\Http\Resources\SongResource;

class FavoriteController extends Controller
{
    public function toggle()
    {
        $favorited = true;

        return $favorited
            ? SongResource::make(['id' => 1, 'title' => 'x'])
            : response()->noContent();
    }

    public function scoped()
    {
        return SongResource::make(['id' => 1])->for(request()->user());
    }

    public function bareArray()
    {
        return [
            'current' => null,
            'count' => $this->service->count(),
        ];
    }

    public function matched($result)
    {
        return match ($result) {
            'changed' => response()->noContent(),
            'taken' => abort(409),
        };
    }

    public function redirected()
    {
        return redirect('/')->with('status', 'done');
    }
}
