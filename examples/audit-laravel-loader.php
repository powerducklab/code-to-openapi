<?php
/** Autoload only the pinned dependencies needed by the native audit. */
spl_autoload_register(function($name)use($root,$packages){
 $maps=[['Brick\\Math\\',$packages.'/brick-math/src/'],['Symfony\\Component\\HttpFoundation\\',$packages.'/http-foundation/'],['Illuminate\\Support\\',$packages.'/laravel/src/Illuminate/Collections/'],['Illuminate\\Support\\',$packages.'/laravel/src/Illuminate/Macroable/'],['Illuminate\\Support\\',$packages.'/laravel/src/Illuminate/Conditionable/'],['Illuminate\\Support\\',$packages.'/laravel/src/Illuminate/Reflection/'],['Illuminate\\',$packages.'/laravel/src/Illuminate/'],['Psr\\Container\\',$packages.'/container/src/'],['Doctrine\\Inflector\\',$packages.'/inflector/src/'],['App\\',$root.'/app/']];
 foreach($maps as[$prefix,$dir])if(str_starts_with($name,$prefix)){
  $file=$dir.str_replace('\\','/',substr($name,strlen($prefix))).'.php';if(is_file($file)){require $file;return;}
 }
});
require $packages.'/laravel/src/Illuminate/Collections/helpers.php';
require $packages.'/laravel/src/Illuminate/Support/helpers.php';
