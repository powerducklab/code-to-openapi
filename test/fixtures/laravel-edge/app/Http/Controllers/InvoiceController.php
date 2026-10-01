<?php

namespace App\Http\Controllers;

use App\Models\Invoice;
use Illuminate\Http\Request;

class InvoiceController extends Controller
{
    public function index()
    {
        return response()->json(Invoice::all());
    }

    public function store(Request $request)
    {
        $valid = $request->validate([
            'order_id' => 'required|string',
            'amount' => 'required|numeric',
        ]);
        return response()->json(Invoice::create($valid), 201);
    }

    public function show(string $invoice)
    {
        return response()->json(Invoice::findOrFail($invoice));
    }

    public function update(string $invoice, Request $request)
    {
        $invoice = Invoice::findOrFail($invoice);
        $invoice->update($request->all());
        return response()->json($invoice);
    }

    public function destroy(string $invoice)
    {
        return response()->noContent();
    }
}
