<?php
/** Original request rules + native Laravel Validator. No DB/auth/custom rules. */
$root=$argv[1];$packages=$argv[2];$output=$argv[3];
require __DIR__.'/audit-laravel-loader.php';
$translator=new Illuminate\Translation\Translator(new Illuminate\Translation\ArrayLoader(),'en');
$factory=new Illuminate\Validation\Factory($translator);
$cases=[
 ['App\\Http\\Requests\\API\\AiRequest',[
  ['prompt'=>'hello'],[],['prompt'=>null],['prompt'=>false],['prompt'=>str_repeat('a',501)],
  ['prompt'=>'hello','current_song_id'=>null],['prompt'=>'hello','current_song_id'=>4],
 ]],
 ['App\\Http\\Requests\\API\\MediaBrowser\\PaginateFolderSongsRequest',[
  [],['folder'=>null],['folder'=>'music'],['folder'=>4],
 ]],
 ['App\\Http\\Requests\\API\\GetUserInvitationRequest',[
  [],['token'=>null],['token'=>'abc'],['token'=>''],['token'=>4],
 ]],
 ['App\\Http\\Requests\\API\\Upload\\CompletePresignedUploadRequest',[
  [],['key'=>'file'],['key'=>null],['key'=>4],
 ]],
];
$rows=[];
foreach($cases as[$class,$inputs]){
 $request=new $class();$rules=$request->rules();$probes=[];
 foreach($inputs as$input){$validator=$factory->make($input,$rules);$probes[]=['input'=>$input,'passes'=>$validator->passes(),'failed'=>$validator->failed()];}
 $rows[]=['class'=>$class,'rules'=>$rules,'probes'=>$probes];
}
file_put_contents($output,json_encode($rows,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));echo count($rows)." request classes validated\n";
