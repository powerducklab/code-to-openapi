<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property int $product_id
 * @property int $rating
 * @property string $author
 * @property string|null $comment
 */
class Review extends Model
{
    protected $fillable = ['product_id', 'rating', 'author', 'comment'];
}
