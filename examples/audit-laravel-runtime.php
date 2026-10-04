<?php
/** Native Laravel router, original Koel routes/controllers. No business handlers run. */
$root=$argv[1];$packages=$argv[2];$output=$argv[3];
require __DIR__.'/audit-laravel-loader.php';
$container=new Illuminate\Container\Container();
$router=new Illuminate\Routing\Router(new Illuminate\Events\Dispatcher($container),$container);
$container->instance('router',$router);
// Explicit enabled configuration; no production service or credentials used.
$container->instance('YouTube',new class {public function enabled(){return true;}});
Illuminate\Support\Facades\Facade::setFacadeApplication($container);
require $root.'/routes/api.base.php';
$rows=[];
foreach($router->getRoutes()as$route)$rows[]=['path'=>'/'.$route->uri(),'methods'=>$route->methods(),'action'=>$route->getActionName(),'middleware'=>$route->middleware(),'where'=>$route->wheres];
file_put_contents($output,json_encode($rows,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));echo count($rows)." routes\n";
