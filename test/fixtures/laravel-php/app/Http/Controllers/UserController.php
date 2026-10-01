<?php

namespace App\Http\Controllers;

use App\Http\Requests\CreateUserRequest;
use App\Models\User;
use Illuminate\Http\Request;

class UserController extends Controller
{
    public function index(Request $request)
    {
        $q = $request->query('q');
        $page = $request->query('page');
        return response()->json(User::all());
    }

    public function show(string $id)
    {
        return response()->json(User::findOrFail($id));
    }

    public function store(CreateUserRequest $request)
    {
        $data = $request->validated();
        return response()->json(User::create($data), 201);
    }

    public function destroy(string $id)
    {
        User::destroy($id);
        return response()->noContent();
    }
}
