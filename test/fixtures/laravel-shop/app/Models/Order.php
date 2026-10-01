<?php

namespace App\Models;

use App\Enums\OrderStatus;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property int $product_id
 * @property int $quantity
 * @property float $total
 * @property OrderStatus $status
 */
class Order extends Model
{
    protected $fillable = ['product_id', 'quantity', 'total', 'status'];

    protected $casts = [
        'quantity' => 'integer',
        'total' => 'float',
        'status' => OrderStatus::class,
    ];
}
