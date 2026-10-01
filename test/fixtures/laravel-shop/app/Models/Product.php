<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Enums\Category;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * @property int $id
 * @property string $sku
 * @property string $name
 * @property float $price
 * @property bool $active
 * @property string[] $tags
 * @property Category|null $category
 * @property Review[] $reviews
 */
class Product extends Model
{
    protected $fillable = ['sku', 'name', 'price', 'active', 'tags'];

    protected $casts = [
        'price' => 'float',
        'active' => 'boolean',
        'tags' => 'array',
    ];

    public function reviews(): HasMany
    {
        return $this->hasMany(Review::class);
    }
}
