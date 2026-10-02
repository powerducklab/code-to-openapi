<?php

namespace App\Http\Controllers;

use App\Models\Album;
use Illuminate\Http\Request;

class AlbumController extends Controller
{
    public function index()
    {
        return response()->json(Album::all());
    }

    public function store(Request $request)
    {
        return response()->json(Album::create($request->all()), 201);
    }

    public function show(Album $album)
    {
        return response()->json($album);
    }

    public function update(Request $request, Album $album)
    {
        $album->update($request->all());
        return response()->json($album);
    }

    public function destroy(Album $album)
    {
        $album->delete();
        return response()->noContent();
    }
}
